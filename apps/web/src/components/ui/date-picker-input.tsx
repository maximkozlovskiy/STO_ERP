'use client';

import { useState, useRef, useEffect } from 'react';
import { DayPicker } from 'react-day-picker';
import { uk } from 'date-fns/locale';
import { format, parse, isValid } from 'date-fns';
import { Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DatePickerInputProps {
  value: string;           // YYYY-MM-DD для API
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  errorMessage?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  min?: string;            // YYYY-MM-DD
  max?: string;            // YYYY-MM-DD
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
  value, onChange, label, hint, errorMessage, required, disabled, placeholder = 'ДД.ММ.РРРР', className
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

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setInputText(text);
    // Try to parse DD.MM.YYYY manually typed input
    if (text.length === 10) {
      const parsed = parse(text, 'dd.MM.yyyy', new Date());
      if (isValid(parsed)) {
        onChange(format(parsed, 'yyyy-MM-dd'));
      }
    }
    if (!text) onChange('');
  };

  const handleDaySelect = (day: Date | undefined) => {
    if (!day) return;
    onChange(format(day, 'yyyy-MM-dd'));
    setOpen(false);
  };

  const selected = parseApiDate(value);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {label && (
        <label className="block text-[13px] font-medium text-foreground mb-1">
          {label}{required && <span className="text-destructive ml-0.5">*</span>}
        </label>
      )}
      <div className="relative">
        <input
          type="text"
          value={inputText}
          onChange={handleInputChange}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={10}
          className={cn(
            'w-full h-9 rounded-lg border bg-input px-3 pr-9 text-sm text-foreground placeholder:text-muted-foreground',
            'focus:outline-none focus:ring-2 focus:ring-ring transition-colors',
            errorMessage ? 'border-destructive-border focus:ring-destructive/20' : 'border-border',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        />
        <button type="button" onClick={() => !disabled && setOpen(v => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
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
            classNames={{
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
              day_button: cn(
                'w-8 h-8 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors',
                'focus:outline-none focus:ring-2 focus:ring-ring'
              ),
              selected: 'bg-primary text-primary-foreground hover:bg-primary rounded-lg',
              today: 'font-bold text-primary',
              outside: 'text-muted-foreground opacity-40',
              disabled: 'opacity-30 cursor-not-allowed',
            }}
          />
        </div>
      )}
    </div>
  );
}
