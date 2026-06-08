'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker } from 'react-day-picker';
import { uk } from 'date-fns/locale';
import { format, parse, isValid } from 'date-fns';
import { Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';

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

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = ['00', '15', '30', '45'];

interface DateTimePickerInputProps {
  value: string; // "YYYY-MM-DDTHH:mm" або "" (у timeOnly режимі: "HH:mm" або "")
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  timeOnly?: boolean; // лише вибір часу, без DayPicker
  minHour?: number; // мінімальна допустима година (включно)
  maxHour?: number; // максимальна допустима година (включно)
}

function parseDateTime(value: string): { date: Date | undefined; time: string } {
  if (!value) return { date: undefined, time: '' };
  const [datePart, timePart] = value.split('T');
  const d = parse(datePart, 'yyyy-MM-dd', new Date());
  const time = timePart ? timePart.slice(0, 5) : '';
  return { date: isValid(d) ? d : undefined, time };
}

function formatDisplay(value: string, timeOnly = false): string {
  if (timeOnly) return value ? value.slice(0, 5) : '';
  const { date, time } = parseDateTime(value);
  if (!date) return '';
  return `${format(date, 'dd.MM.yyyy')}${time ? ` ${time}` : ''}`;
}

export function DateTimePickerInput({
  value,
  onChange,
  label,
  required,
  disabled,
  placeholder,
  className,
  timeOnly = false,
  minHour,
  maxHour,
}: DateTimePickerInputProps) {
  placeholder = placeholder ?? (timeOnly ? 'ГГ:ХХ' : 'ДД.ММ.РРРР ГГ:ХХ');
  const availableHours = useMemo(
    () =>
      HOURS.filter(
        h => (minHour === undefined || +h >= minHour) && (maxHour === undefined || +h <= maxHour),
      ),
    [minHour, maxHour],
  );
  const [open, setOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { date: selectedDate, time: selectedTime } = useMemo(
    () => (timeOnly ? { date: undefined, time: value.slice(0, 5) } : parseDateTime(value)),
    [value, timeOnly],
  );
  // Bug #378: default hour fallback має поважати minHour/maxHour, інакше при
  // відкритті picker з порожнім value та minHour=10 у `<select value="09">`
  // не буде відповідної `<option>` (React warning + state-mismatch UX).
  const fallbackHour = availableHours[0] ?? '09';
  const selectedHour = selectedTime ? selectedTime.slice(0, 2) : fallbackHour;
  const selectedMinute = selectedTime ? selectedTime.slice(3, 5) : '00';

  useEffect(() => {
    setMounted(true);
  }, []);

  const applyTime = useCallback(
    (hour: string, minute: string) => {
      if (timeOnly) {
        onChange(`${hour}:${minute}`);
        return;
      }
      const datePart = selectedDate
        ? format(selectedDate, 'yyyy-MM-dd')
        : format(new Date(), 'yyyy-MM-dd');
      onChange(`${datePart}T${hour}:${minute}`);
    },
    [timeOnly, selectedDate, onChange],
  );

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setDropdownPos({
      top: rect.bottom + window.scrollY + 4,
      left: rect.left + window.scrollX,
    });
  }, []);

  const handleOpen = () => {
    if (disabled) return;
    updatePos();
    setOpen(v => !v);
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reposition on scroll/resize.
  // sto-optimize: passive listeners — обробник не викликає preventDefault, тому позначення
  // passive дозволяє браузеру не блокувати скрол на awaiting handler. capture:true на scroll
  // потрібен щоб ловити скрол у будь-якому батьківському контейнері (modal body, sidebar).
  useEffect(() => {
    if (!open) return;
    const handler = () => updatePos();
    const scrollOpts = { capture: true, passive: true } as const;
    const resizeOpts = { passive: true } as const;
    window.addEventListener('scroll', handler, scrollOpts);
    window.addEventListener('resize', handler, resizeOpts);
    return () => {
      window.removeEventListener('scroll', handler, scrollOpts);
      window.removeEventListener('resize', handler);
    };
  }, [open, updatePos]);

  const handleDaySelect = (day: Date | undefined) => {
    if (!day) return;
    const datePart = format(day, 'yyyy-MM-dd');
    const time = selectedTime || '09:00';
    onChange(`${datePart}T${time}`);
  };

  return (
    <div ref={triggerRef} className={cn('relative', className)}>
      {label && (
        <label className="block text-[13px] font-medium text-foreground mb-1">
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </label>
      )}
      <div className="relative">
        <input
          type="text"
          readOnly
          value={formatDisplay(value, timeOnly)}
          placeholder={placeholder}
          disabled={disabled}
          onClick={handleOpen}
          className={cn(
            'w-full h-9 rounded border bg-surface px-3 pr-9 text-[14px] text-foreground placeholder:text-muted-foreground cursor-pointer',
            'border-border hover:border-border-hover',
            'focus:outline-none focus:border-primary focus:ring-3 focus:ring-brand-100 transition-all duration-150',
            disabled && 'opacity-60 cursor-not-allowed bg-secondary',
          )}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={handleOpen}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <Calendar className="h-4 w-4" />
        </button>
      </div>

      {mounted &&
        open &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: 'absolute',
              top: dropdownPos.top,
              left: dropdownPos.left,
              zIndex: 9999,
            }}
            className="bg-surface border border-border rounded-xl shadow-lg flex"
          >
            {/* Calendar — hidden in timeOnly mode */}
            {!timeOnly && (
              <div className="p-3 border-r border-border">
                <DayPicker
                  mode="single"
                  selected={selectedDate}
                  onSelect={handleDaySelect}
                  locale={uk}
                  weekStartsOn={1}
                  showOutsideDays
                  classNames={DAY_PICKER_CLASS_NAMES}
                />
              </div>
            )}

            {/* Time selects */}
            <div className="flex flex-col justify-center gap-3 px-4 border-l border-border min-w-35">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Час
              </p>
              <div className="flex items-center gap-2">
                <div className="flex flex-col gap-1 flex-1">
                  <span className="text-[11px] text-muted-foreground">Год.</span>
                  <select
                    value={selectedHour}
                    onChange={e => applyTime(e.target.value, selectedMinute)}
                    className="h-9 rounded border border-border bg-surface text-[14px] text-foreground px-2 focus:outline-none focus:border-primary focus:ring-3 focus:ring-brand-100"
                  >
                    {availableHours.map(h => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="mt-5 text-muted-foreground font-medium">:</span>
                <div className="flex flex-col gap-1 flex-1">
                  <span className="text-[11px] text-muted-foreground">Хв.</span>
                  <select
                    value={selectedMinute}
                    onChange={e => applyTime(selectedHour, e.target.value)}
                    className="h-9 rounded border border-border bg-surface text-[14px] text-foreground px-2 focus:outline-none focus:border-primary focus:ring-3 focus:ring-brand-100"
                  >
                    {MINUTES.map(m => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="mt-1 text-[13px] font-medium text-primary hover:bg-primary/10 rounded-lg py-1.5 transition-colors"
              >
                Готово
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
