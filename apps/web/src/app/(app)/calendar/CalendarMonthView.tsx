'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Plus } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { woStatusLabel } from '@/i18n/enumLabel';
import type { CalendarSlot, MonthSlots } from './calendar.types';
import { fmtTime, toDateString } from './calendar.utils';
import {
  CATEGORY_VIEW,
  SLOT_TYPE_ICON,
  slotCategory,
  slotType,
  type MonthEntry,
} from './calendar-categories';
import { monthCards } from './calendar-month';
import { CalendarCategoryCounters } from './CalendarCategoryCounters';

interface CalendarMonthViewProps {
  yearMonth: string; // 'YYYY-MM'
  monthSlots: MonthSlots;
  monthLoading: boolean;
  monthError: boolean;
  nowMs: number;
  /** Вид «День» на цю дату (клік по клітинці, «ще N», дія «Відкрити день»). */
  onDayClick: (dateStr: string) => void;
  /** Картка запису → та сама форма, що й у виді «День» (BR-CAL-009). */
  onOpenSlot: (slot: CalendarSlot) => void;
  /** Дія «Новий запис на цю дату»; без неї (механік — лише перегляд) дії немає. */
  onNewOnDate?: (dateStr: string) => void;
}

/** Наскільки блідшає фон завантаженості минулого дня (раніше — `opacity-60` кнопки). */
const PAST_DIM = 0.6;

const DAY_LABEL_KEYS = [
  'month.weekdays.mon',
  'month.weekdays.tue',
  'month.weekdays.wed',
  'month.weekdays.thu',
  'month.weekdays.fri',
  'month.weekdays.sat',
  'month.weekdays.sun',
] as const;

/** 'YYYY-MM-DD' → 'DD.MM.YYYY' для назв дій (локаль проєкту). */
const dmy = (dayStr: string) => dayStr.split('-').reverse().join('.');

// Кнопки на клітинці стоять поверх фону завантаженості — власна підкладка `bg-surface`
// тримає контраст (той самий прийом, що й у рядка лічильників).
// Сенсорний екран (`pointer-coarse`): дії видно завжди, і кожна ціль — щонайменше 24×24 px
// (WCAG 2.5.8; Bug #872): 20×20 з проміжком 2 px давали промахи по сусідній кнопці.
const CELL_ACTION =
  'inline-flex h-5 w-5 items-center justify-center rounded border border-border bg-surface text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:h-6 pointer-coarse:w-6';
/** Мінімальна висота цілі на сенсорному екрані — картка запису й «ще N» (WCAG 2.5.8). */
const COARSE_TARGET = 'pointer-coarse:min-h-6';

interface MonthSlotCardProps {
  entry: MonthEntry;
  nowMs: number;
  onOpen: (slot: CalendarSlot) => void;
}

const MonthSlotCard = memo(function MonthSlotCard({ entry, nowMs, onOpen }: MonthSlotCardProps) {
  const { t } = useTranslation('calendar');
  const { slot } = entry;
  const category = slotCategory(entry, nowMs);
  const { icon: CategoryIcon, className, barClassName } = CATEGORY_VIEW[category];
  const type = slotType(slot.type);
  const TypeIcon = SLOT_TYPE_ICON[type];
  const time = fmtTime(slot.startAt);
  const categoryLabel = t(`month.category.${category}`);
  const typeLabel = t(`month.type.${type}`);
  // Головне — номер наряду (без наряду — «Без наряду»): не обрізається. Другорядне — клієнт
  // (без наряду — клієнт або примітка) — обрізається. Механік клієнта не отримує (API віддає
  // лише номер наряду) — тоді другорядного немає.
  const main = slot.workOrderNumber ?? t('month.card.noWorkOrder');
  const secondary = slot.workOrderNumber
    ? slot.counterpartyName
    : (slot.counterpartyName ?? slot.notes);
  const text = secondary ? `${main} · ${secondary}` : main;
  const title = [
    `${time}–${fmtTime(slot.endAt)}${slot.parentSlotId ? ` (${t('month.card.continuation')})` : ''}`,
    slot.workOrderNumber
      ? `${slot.workOrderNumber}${slot.workOrderStatus ? ` · ${woStatusLabel(slot.workOrderStatus)}` : ''}`
      : t('month.card.noWorkOrder'),
    slot.counterpartyName,
    slot.cpPhone,
    [slot.vehicleSummary, slot.vehiclePlate].filter(Boolean).join(' ') || null,
    slot.notes,
    `${typeLabel} · ${categoryLabel}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <button
      type="button"
      onClick={e => {
        // Інакше клік дійшов би до клітинки й відкрив вид «День» замість запису.
        e.stopPropagation();
        onOpen(slot);
      }}
      title={title}
      aria-label={`${time} ${text}. ${typeLabel}. ${categoryLabel}`}
      data-testid="month-slot-card"
      data-category={category}
      className={`flex w-full min-w-0 items-center gap-1 rounded border border-border border-l-4 ${barClassName} bg-surface px-1 py-0.5 text-left text-[11px] leading-tight text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${COARSE_TARGET}`}
    >
      <TypeIcon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 tabular-nums text-muted-foreground">{time}</span>
      {/* Номер — природної ширини (обрізається лише коли не влазить сам); клієнт — `flex-1`
          з нульовою базою, тобто лише залишок місця. Іконки `shrink-0` лишаються видимими. */}
      <span className="min-w-0 truncate font-medium" data-part="main">
        {main}
      </span>
      {secondary && (
        <span className="min-w-0 flex-1 truncate" data-part="secondary">
          · {secondary}
        </span>
      )}
      <CategoryIcon className={`h-3 w-3 shrink-0 ${className}`} aria-hidden="true" />
    </button>
  );
});

export function CalendarMonthView({
  yearMonth,
  monthSlots,
  monthLoading,
  monthError,
  nowMs,
  onDayClick,
  onOpenSlot,
  onNewOnDate,
}: CalendarMonthViewProps) {
  const { t } = useTranslation('calendar');
  const [y, m] = yearMonth ? yearMonth.split('-').map(Number) : [0, 0];
  if (!y || !m) return null;

  const firstDay = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayStr = nowMs ? toDateString(new Date(nowMs)) : '';

  // Monday-first: 0=Mon … 6=Sun
  const startOffset = (firstDay.getDay() + 6) % 7;
  const cells: (string | null)[] = [
    ...Array<null>(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const d = i + 1;
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }),
  ];
  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null);

  const maxSlots = Math.max(1, ...Object.values(monthSlots).map(v => v.total));

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {monthLoading && (
        <div className="flex justify-center py-12">
          <Spinner size="md" />
        </div>
      )}
      {!monthLoading && monthError && (
        <div className="px-4 py-8 text-center text-sm text-destructive-text">
          {t('month.loadError')}
        </div>
      )}
      {!monthLoading && !monthError && (
        <>
          {/* Day-of-week header */}
          <div className="grid grid-cols-7 border-b border-border">
            {DAY_LABEL_KEYS.map(dk => (
              <div
                key={dk}
                className="py-2 text-center text-xs font-medium text-muted-foreground bg-secondary"
              >
                {t(dk)}
              </div>
            ))}
          </div>
          {/* Weeks */}
          {Array.from({ length: cells.length / 7 }, (_, wi) => (
            <div key={wi} className="grid grid-cols-7 border-b border-border last:border-b-0">
              {cells.slice(wi * 7, wi * 7 + 7).map((dayStr, di) => {
                if (!dayStr)
                  return (
                    <div
                      key={di}
                      className="min-h-36 bg-secondary/40 border-r border-border last:border-r-0"
                    />
                  );
                const info = monthSlots[dayStr];
                const total = info?.total ?? 0;
                const isToday = dayStr === todayStr;
                const isPast = nowMs ? dayStr < todayStr : false;
                const load = total / maxSlots;
                // Минулий день блідший: раніше `opacity-60` на всій кнопці, але вона гасила й
                // лічильники категорій (BR-CAL-008) — саме «прострочено» стоїть у минулих днях.
                // Тепер блідне фон і число дня, лічильники лишаються контрастними.
                const bgAlpha =
                  total === 0 ? 0 : Math.max(0.08, load * 0.5) * (isPast ? PAST_DIM : 1);
                const dayNum = parseInt(dayStr.slice(8), 10);
                const entries = info?.entries ?? [];
                const { cards, more } = monthCards(entries);
                const date = dmy(dayStr);
                return (
                  // Клітинка — `div`, а не кнопка: усередині кнопки карток і дій (BR-CAL-009).
                  // Клік по вільному місцю — вид «День» (миша); з клавіатури — дія «Відкрити день».
                  <div
                    key={dayStr}
                    onClick={() => onDayClick(dayStr)}
                    title={total > 0 ? t('month.records', { count: total }) : undefined}
                    data-testid="month-day"
                    data-date={dayStr}
                    className="group relative min-h-36 min-w-0 cursor-pointer border-r border-border last:border-r-0 p-2 text-left transition-colors hover:bg-primary/5 flex flex-col gap-1"
                    style={
                      total > 0
                        ? {
                            backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round(bgAlpha * 100)}%, transparent)`,
                          }
                        : undefined
                    }
                  >
                    <span
                      className={`text-sm font-semibold leading-none ${isToday ? 'flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs' : 'text-foreground'} ${isPast ? 'opacity-60' : ''}`}
                    >
                      {dayNum}
                    </span>
                    {/* Дії при наведенні; з клавіатури — з'являються, щойно фокус у клітинці.
                        На сенсорних екранах наведення немає — показані завжди. */}
                    <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:top-0.5 pointer-coarse:right-0.5 pointer-coarse:gap-1 pointer-coarse:opacity-100">
                      <button
                        type="button"
                        className={CELL_ACTION}
                        aria-label={t('month.openDay', { date })}
                        title={t('month.openDay', { date })}
                        onClick={e => {
                          e.stopPropagation();
                          onDayClick(dayStr);
                        }}
                      >
                        <Eye className="h-3 w-3" aria-hidden="true" />
                      </button>
                      {/* Минулий день: новий запис у минуле форма однаково не збереже. */}
                      {!isPast && onNewOnDate && (
                        <button
                          type="button"
                          className={CELL_ACTION}
                          aria-label={t('month.newRecord', { date })}
                          title={t('month.newRecord', { date })}
                          onClick={e => {
                            e.stopPropagation();
                            onNewOnDate(dayStr);
                          }}
                        >
                          <Plus className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <CalendarCategoryCounters
                      entries={entries}
                      nowMs={nowMs}
                      testId="month-day-categories"
                    />
                    {cards.length > 0 && (
                      <div className="flex min-w-0 flex-col gap-0.5">
                        {cards.map(e => (
                          <MonthSlotCard
                            key={e.slot.id}
                            entry={e}
                            nowMs={nowMs}
                            onOpen={onOpenSlot}
                          />
                        ))}
                      </div>
                    )}
                    {more > 0 && (
                      <button
                        type="button"
                        className={`self-start inline-flex items-center rounded bg-surface px-1 py-0.5 text-[11px] font-medium leading-none text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${COARSE_TARGET}`}
                        aria-label={t('month.card.moreAria', { count: more, date })}
                        onClick={e => {
                          e.stopPropagation();
                          onDayClick(dayStr);
                        }}
                      >
                        {t('month.card.more', { count: more })}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
