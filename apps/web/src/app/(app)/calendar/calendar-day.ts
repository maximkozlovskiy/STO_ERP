import type { TFunction } from 'i18next';
import { WO_EDITABLE_STATUSES } from '@sto/shared';
import type { ConfirmOptions } from '@/hooks/useConfirm';
import { woStatusLabel } from '@/i18n/enumLabel';
import type { CalendarSlot } from './calendar.types';
import { slotCategory, type SlotCategory } from './calendar-categories';
import { chainKey, countsAsLoad } from './calendar-month';
import { decimalHoursToISO, fmtKyivDate, fmtTime, kyivHours, toDateString } from './calendar.utils';

/**
 * Категорія блоку запису у виді «День» (BR-CAL-011) — та сама, що в «Місяці» (BR-CAL-008):
 * «прострочено» — за кінцем ЛАНЦЮЖКА (`chainEnds` із записів дня й наступного дня), а не за
 * кінцем частини, що показана.
 */
export function daySlotCategory(
  slot: Pick<CalendarSlot, 'id' | 'parentSlotId' | 'endAt' | 'workOrderStatus'>,
  chainEnds: ReadonlyMap<string, number>,
  nowMs: number,
): SlotCategory {
  return slotCategory(
    {
      endMs: chainEnds.get(chainKey(slot)) ?? new Date(slot.endAt).getTime(),
      workOrderStatus: slot.workOrderStatus ?? null,
    },
    nowMs,
  );
}

/**
 * BR-WO-027: час і підйомник запису наряду змінюються лише там, де картка наряду змінює планові
 * дати (`WO_EDITABLE_STATUSES`). Повертає статус наряду, що блокує зміну, або `null` — запис без
 * наряду чи наряд у редагованому статусі.
 */
export function workOrderTimeLock(
  slot: Pick<CalendarSlot, 'workOrderId' | 'workOrderStatus'>,
): string | null {
  const status = slot.workOrderStatus;
  return slot.workOrderId && status && !WO_EDITABLE_STATUSES.includes(status) ? status : null;
}

/**
 * BR-WO-024 / BR-CAL-020 (TECH-DEBT (б) №66, №92): межа запису — внутрішня межа багатоденного
 * ланцюжка (наряду чи ручного), яку не тягнуть: початок продовження (`parentSlotId`) і кінець не
 * останнього дня (`chainEndAt` — кінець останньої частини — пізніше за кінець цієї). Тягнуть лише
 * початок першого дня й кінець останнього; сервер на зміну внутрішньої межі відповідає 400
 * `err.calendar.chainInnerEdge`.
 */
export function chainInnerEdge(
  slot: Pick<CalendarSlot, 'parentSlotId' | 'endAt' | 'chainEndAt'>,
  edge: 'start' | 'end',
): boolean {
  if (edge === 'start') return !!slot.parentSlotId;
  return !!slot.chainEndAt && new Date(slot.chainEndAt).getTime() > new Date(slot.endAt).getTime();
}

/**
 * BR-CAL-020 / BR-WO-024 (TECH-DEBT (б) №97): запис (ручний чи наряду), чий ПОЧАТОК ланцюжка
 * (`chainStartAt` — початок першої частини; одноденний — свій початок) уже минув. Такий запис не
 * переноситься й не має ручки початку — сервер відповів би 400 `err.calendar.chainStarted`; кінець
 * останнього дня змінюється. `nowMs` = 0 — час ще не відомий (до гідратації): не розпочатий.
 */
export function chainStarted(
  slot: Pick<CalendarSlot, 'startAt' | 'chainStartAt'>,
  nowMs: number,
): boolean {
  return nowMs > 0 && new Date(slot.chainStartAt ?? slot.startAt).getTime() < nowMs;
}

/**
 * BR-WO-026: видалення запису наряду заблоковане там само, де час і підйомник (`timeLock` —
 * результат `workOrderTimeLock`), крім скасованого наряду (рішення власника 2026-10-19): його
 * запис — залишок старих даних, видаляється без зміни дат закритого наряду. Повертає статус, що
 * блокує видалення, або `null`.
 */
export function workOrderDeleteLock(timeLock: string | null): string | null {
  return timeLock === 'CANCELLED' ? null : timeLock;
}

/** Запис скасованого наряду: видалення не стирає дат наряду (BR-WO-026) — інше підтвердження. */
export function isCancelledWorkOrderSlot(timeLock: string | null): boolean {
  return timeLock === 'CANCELLED';
}

/**
 * Підказка «запис наряду не видаляється» (BR-WO-026) для кнопки видалення; `null` — видалити
 * можна. `t` — простір імен `calendar`; `timeLock` — результат `workOrderTimeLock`.
 */
export function slotDeleteLockHint(t: TFunction, timeLock: string | null): string | null {
  const locked = workOrderDeleteLock(timeLock);
  return locked ? t('slot.woDeleteLocked', { status: woStatusLabel(locked) }) : null;
}

/**
 * Підтвердження видалення запису (BR-WO-026): запис наряду стирає планові дати наряду, запис
 * скасованого наряду — ні, запис без наряду (`woNumber` — `null`) — звичайне підтвердження.
 * Багатоденний запис без наряду (`chainDays` > 1) видаляється весь — «Видалити всі N днів?»
 * (BR-CAL-019); `chainEndAt` — кінець останньої частини для тексту.
 */
export function slotDeleteConfirmOptions(
  t: TFunction,
  woNumber: string | null,
  timeLock: string | null,
  chain: { chainDays?: number | undefined; chainEndAt?: string | undefined } = {},
): ConfirmOptions {
  const days = chain.chainDays ?? 1;
  if (woNumber === null && days > 1)
    return {
      title: t('slot.deleteChainTitle', { count: days }),
      message: chain.chainEndAt
        ? t('slot.deleteChainMessage', {
            end: `${fmtKyivDate(chain.chainEndAt)} ${fmtTime(chain.chainEndAt)}`,
          })
        : t('slot.deleteMessage'),
      variant: 'destructive',
    };
  return {
    title: t('slot.deleteTitle'),
    message:
      woNumber !== null
        ? t(
            isCancelledWorkOrderSlot(timeLock)
              ? 'slot.deleteCancelledWoMessage'
              : 'slot.deleteWoMessage',
            { number: woNumber },
          )
        : t('slot.deleteMessage'),
    variant: 'destructive',
  };
}

/** Поточний час за Києвом як частка робочого вікна дня, %; `null` — не сьогодні. */
function kyivTodayHours(nowMs: number, date: string): number | null {
  if (!nowMs || !date) return null;
  const now = new Date(nowMs);
  // Дата й година — за Києвом (Intl, з переведенням годинника), не за часовим поясом браузера.
  if (toDateString(now) !== date) return null;
  return kyivHours(now.toISOString());
}

/**
 * Лінія «зараз» (BR-CAL-011): відступ від початку робочих годин у % ширини сітки — лише для
 * сьогоднішнього дня за Києвом і лише в межах робочих годин `[startHour, endHour)`; інакше `null`.
 * `nowMs` = 0 — час ще не відомий (до гідратації): лінії немає.
 */
export function nowLinePercent(
  nowMs: number,
  date: string,
  startHour: number,
  endHour: number,
): number | null {
  const h = kyivTodayHours(nowMs, date);
  if (h === null || endHour <= startHour || h < startHour || h >= endHour) return null;
  return ((h - startHour) / (endHour - startHour)) * 100;
}

/**
 * Скільки % ширини сітки приглушено як минуле: минулий день — уся, майбутній — нічого, сьогодні —
 * до лінії «зараз» (до початку робочих годин — нічого, після кінця — уся).
 */
export function pastPercent(
  nowMs: number,
  date: string,
  startHour: number,
  endHour: number,
): number {
  if (!nowMs || !date || endHour <= startHour) return 0;
  const today = toDateString(new Date(nowMs));
  if (date < today) return 100;
  if (date > today) return 0;
  const h = kyivTodayHours(nowMs, date) ?? startHour;
  return Math.min(100, Math.max(0, ((h - startHour) / (endHour - startHour)) * 100));
}

const HOUR_MS = 3_600_000;

/**
 * Завантаження підйомника за день (BR-CAL-011): сума тривалостей його записів у межах робочих
 * годин дня `date` (Київ). Запис, що виходить за межі, обрізається; частина багатоденного запису
 * рахується лише своєю частиною цього дня. Записи скасованих (`CANCELLED`) і видалених нарядів не
 * рахуються (рішення власника 2026-10-16). Результат — години, округлені до 0,5.
 */
export function liftLoadHours(
  slots: readonly Pick<
    CalendarSlot,
    'liftId' | 'startAt' | 'endAt' | 'workOrderStatus' | 'workOrderDeleted'
  >[],
  liftId: string,
  date: string,
  startHour: number,
  endHour: number,
): number {
  const from = new Date(decimalHoursToISO(date, startHour)).getTime();
  const to = new Date(decimalHoursToISO(date, endHour)).getTime();
  if (!(to > from)) return 0;
  let ms = 0;
  for (const s of slots) {
    if (s.liftId !== liftId || !countsAsLoad(s)) continue;
    const a = Math.max(new Date(s.startAt).getTime(), from);
    const b = Math.min(new Date(s.endAt).getTime(), to);
    if (b > a) ms += b - a;
  }
  return Math.round((ms / HOUR_MS) * 2) / 2;
}
