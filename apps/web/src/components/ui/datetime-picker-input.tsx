'use client';

import { useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker } from 'react-day-picker';
import { uk } from 'date-fns/locale';
import { format, parse, isValid } from 'date-fns';
import { Calendar, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { isoToKyivLocalDateTime, kyivToday } from '@/lib/format';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';

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

/** Київські дата 'YYYY-MM-DD' і хвилина доби миті (значення пікера — київський настінний час). */
function kyivParts(d: Date): { ymd: string; minute: number } {
  const local = isoToKyivLocalDateTime(d); // 'YYYY-MM-DDTHH:mm'
  return {
    ymd: local.slice(0, 10),
    minute: Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)),
  };
}

interface DateTimePickerInputProps {
  value: string; // "YYYY-MM-DDTHH:mm" або "" (у timeOnly режимі: "HH:mm" або "")
  onChange: (value: string) => void;
  label?: string;
  /** Мітка перед підписом у тому самому рядку (напр. «План» / «Факт» у картці наряду). */
  labelAddon?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  timeOnly?: boolean; // лише вибір часу, без DayPicker
  minHour?: number; // мінімальна допустима година (включно)
  maxHour?: number; // максимальна допустима година (включно)
  /**
   * Година закриття (кінець робочого дня): доступна лише як «HH:00» — останній момент дня для
   * часу завершення. Замінює `maxHour`. Для часу початку — `maxHour = закриття − 1`.
   */
  closeHour?: number;
  /**
   * Найраніший допустимий момент (BR-WO-019 — планові дати не в минулому): дні до нього
   * недоступні в календарі, у його день — лише час від нього (хвилини з кроком 15 округлюються
   * вгору). Порівнюється з київським настінним часом, яким є значення пікера.
   */
  minDateTime?: Date;
  /** Кнопка «Очистити дату» біля заповненого поля (значення стає ''). */
  clearable?: boolean;
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
  labelAddon,
  required,
  disabled,
  placeholder,
  className,
  inputClassName,
  timeOnly = false,
  minHour,
  maxHour,
  closeHour,
  minDateTime,
  clearable = false,
}: DateTimePickerInputProps) {
  const { t } = useTranslation('common');
  const showClear = Boolean(clearable && value && !disabled);
  placeholder =
    placeholder ??
    (timeOnly ? t('datePicker.timePlaceholder') : t('datePicker.dateTimePlaceholder'));
  const minParts = useMemo(() => (minDateTime ? kyivParts(minDateTime) : null), [minDateTime]);

  /** Чи можна обрати час `h:m` у день `ymd` (`null` — день не важливий: timeOnly). */
  const isAllowed = useCallback(
    (ymd: string | null, h: number, m: number) => {
      if (minHour !== undefined && h < minHour) return false;
      if (closeHour !== undefined) {
        if (h > closeHour || (h === closeHour && m > 0)) return false;
      } else if (maxHour !== undefined && h > maxHour) return false;
      if (minParts && ymd !== null) {
        if (ymd < minParts.ymd) return false;
        if (ymd === minParts.ymd && h * 60 + m < minParts.minute) return false;
      }
      return true;
    },
    [minHour, maxHour, closeHour, minParts],
  );
  const hoursFor = useCallback(
    (ymd: string | null) => HOURS.filter(h => MINUTES.some(m => isAllowed(ymd, +h, +m))),
    [isAllowed],
  );
  const minutesFor = useCallback(
    (ymd: string | null, h: string) => MINUTES.filter(m => isAllowed(ymd, +h, +m)),
    [isAllowed],
  );
  /** Перший доступний час дня (вибір дня ставить його, якщо поточний час недоступний). */
  const firstTime = useCallback(
    (ymd: string | null): string | null => {
      const h = hoursFor(ymd)[0];
      if (h === undefined) return null;
      const m = minutesFor(ymd, h)[0];
      return m === undefined ? null : `${h}:${m}`;
    },
    [hoursFor, minutesFor],
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
  // День, до якого застосовується час: обраний, інакше сьогодні (так само його бере applyTime).
  const todayYmd = minParts?.ymd ?? kyivToday();
  const selectedYmd = timeOnly
    ? null
    : selectedDate
      ? format(selectedDate, 'yyyy-MM-dd')
      : todayYmd;
  const availableHours = useMemo(() => hoursFor(selectedYmd), [hoursFor, selectedYmd]);
  // default hour fallback має поважати обмеження, інакше при відкритті picker з порожнім value
  // та minHour=10 у `<select value="09">` не буде відповідної `<option>` (React warning).
  const fallbackHour = availableHours[0] ?? '09';
  const selectedHour = selectedTime ? selectedTime.slice(0, 2) : fallbackHour;
  const availableMinutes = useMemo(
    () => minutesFor(selectedYmd, selectedHour),
    [minutesFor, selectedYmd, selectedHour],
  );
  const selectedMinute = selectedTime ? selectedTime.slice(3, 5) : (availableMinutes[0] ?? '00');
  // Збережене значення поза обмеженнями (старий наряд із минулими датами) показується
  // недоступною опцією — select не підміняє його мовчки першою доступною.
  const hourOptions = availableHours.includes(selectedHour)
    ? availableHours
    : [...availableHours, selectedHour].sort();
  const minuteOptions = availableMinutes.includes(selectedMinute)
    ? availableMinutes
    : [...availableMinutes, selectedMinute].sort();
  // Дні до першого дня з доступним часом — недоступні (сьогодні після закриття — теж).
  const disabledDays = useMemo(() => {
    if (!minParts) return undefined;
    const today = parse(minParts.ymd, 'yyyy-MM-dd', new Date());
    if (firstTime(minParts.ymd) !== null) return { before: today };
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { before: tomorrow };
  }, [minParts, firstTime]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const applyTime = useCallback(
    (hour: string, minute: string) => {
      // Нова година з хвилинами, яких у ній немає (09:00 при мінімумі 09:30) → перша доступна.
      const minutes = minutesFor(selectedYmd, hour);
      const m = minutes.includes(minute) ? minute : (minutes[0] ?? minute);
      if (timeOnly) {
        onChange(`${hour}:${m}`);
        return;
      }
      onChange(`${selectedYmd ?? todayYmd}T${hour}:${m}`);
    },
    [timeOnly, selectedYmd, todayYmd, minutesFor, onChange],
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

  // Escape закриває ЛИШЕ попап: відкритий попап — шар Escape над вікном (lib/escape-layers), тож
  // до батьківського <Modal> клавіша не доходить. Шар без scopeRef: фокус може бути і в інпуті, і в
  // <select> попапа (він у порталі на document.body).
  useEscapeLayer(open, () => setOpen(false));

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
    // Обраний час лишається, якщо він доступний у новий день; інакше — перша доступна година дня.
    const [h, m] = (selectedTime || '').split(':').map(Number);
    const keep =
      selectedTime && h !== undefined && m !== undefined && isAllowed(datePart, h, m)
        ? selectedTime
        : null;
    onChange(`${datePart}T${keep ?? firstTime(datePart) ?? selectedTime ?? '09:00'}`);
  };

  return (
    <div ref={triggerRef} className={cn('relative', className)}>
      {label && (
        <label className="block text-[13px] font-medium text-foreground mb-1">
          {labelAddon}
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
            'w-full h-9 rounded border bg-surface px-3 text-[14px] text-foreground placeholder:text-muted-foreground cursor-pointer',
            // Місце під іконку календаря; з кнопкою очищення — під обидві.
            showClear ? 'pr-14' : 'pr-9',
            'border-input hover:border-input-hover',
            'focus:outline-none focus:border-primary focus:ring-3 focus:ring-brand-100 transition-all duration-150',
            disabled && 'opacity-60 cursor-not-allowed bg-secondary',
            inputClassName,
          )}
        />
        {showClear && (
          <button
            type="button"
            // Назва містить назву поля: у картці наряду дві такі кнопки (початок і завершення).
            aria-label={label ? `${t('clearDate')}: ${label}` : t('clearDate')}
            title={t('clearDate')}
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
            className="absolute right-7 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
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
                  disabled={disabledDays}
                  // Відкривається на місяці значення, а без нього — на першому доступному дні:
                  // інакше планове завершення через місяць показувало б поточний місяць, де
                  // недоступне все.
                  defaultMonth={selectedDate ?? disabledDays?.before}
                  classNames={DAY_PICKER_CLASS_NAMES}
                />
              </div>
            )}

            {/* Time selects */}
            <div className="flex flex-col justify-center gap-3 px-4 border-l border-border min-w-35">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                {t('datePicker.time')}
              </p>
              <div className="flex items-center gap-2">
                <div className="flex flex-col gap-1 flex-1">
                  <span className="text-[11px] text-muted-foreground">
                    {t('datePicker.hourShort')}
                  </span>
                  <select
                    aria-label={t('datePicker.hour')}
                    value={selectedHour}
                    onChange={e => applyTime(e.target.value, selectedMinute)}
                    className="h-9 rounded border border-input bg-surface text-[14px] text-foreground px-2 focus:outline-none focus:border-primary focus:ring-3 focus:ring-brand-100"
                  >
                    {hourOptions.map(h => (
                      <option key={h} value={h} disabled={!availableHours.includes(h)}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="mt-5 text-muted-foreground font-medium">:</span>
                <div className="flex flex-col gap-1 flex-1">
                  <span className="text-[11px] text-muted-foreground">
                    {t('datePicker.minuteShort')}
                  </span>
                  <select
                    aria-label={t('datePicker.minutes')}
                    value={selectedMinute}
                    onChange={e => applyTime(selectedHour, e.target.value)}
                    className="h-9 rounded border border-input bg-surface text-[14px] text-foreground px-2 focus:outline-none focus:border-primary focus:ring-3 focus:ring-brand-100"
                  >
                    {minuteOptions.map(m => (
                      <option key={m} value={m} disabled={!availableMinutes.includes(m)}>
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
                {t('done')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
