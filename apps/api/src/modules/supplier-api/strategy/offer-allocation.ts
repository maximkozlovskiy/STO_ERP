/**
 * Автопідбір пропозицій за стратегією (BR-SOFR-007, 008) — чиста функція, без Nest і Prisma.
 *
 * Вхід: потреба позиції й пропозиції з цінами вже в гривні (`priceUah`; null — курсу немає,
 * пропозиція виключається). Вихід: частини «пропозиція × кількість» і непокрита решта.
 *
 *  - Термін = `deliveryDays` ?? дні до `deliveryDate` ?? `connectionDefaultDays` ??
 *    `unknownDeliveryDays` (штраф за невідомий термін).
 *  - Замовна кількість — до кратності вгору; обмежена кількість («>10», `qtyIsLowerBound`)
 *    вважається рівною межі; більше за наявне не замовляється.
 *  - Оцінка (менше — краще): CHEAP — сума замовлення, нічия за терміном; FAST — термін, нічия за
 *    сумою; OPTIMAL — `w · norm(ціна) + (1 − w) · norm(термін)`, нормування min–max серед допустимих
 *    пропозицій позиції. Остаточна нічия — `priority` підключення, далі `offerKey`, далі id:
 *    результат не залежить від порядку пропозицій на вході.
 *  - Покриття: найкраща пропозиція, що покриває всю потребу; немає — жадібно за оцінкою: між
 *    складами одного постачальника завжди, між різними — лише коли `allowSplit`.
 */

export type AllocationStrategy = 'FAST' | 'CHEAP' | 'OPTIMAL';

export interface AllocationOffer {
  id: string;
  /** Постачальник (контрагент підключення) — межа поділу без `allowSplit`. */
  supplierId: string;
  connectionPriority: number;
  offerKey: string;
  /** Ціна за одиницю в гривні; null — немає курсу, пропозиція не бере участі. */
  priceUah: number | null;
  qty: number;
  qtyIsLowerBound: boolean;
  multiplicity: number | null;
  deliveryDays: number | null;
  deliveryDate: Date | null;
  connectionDefaultDays: number | null;
  /** Чи можна обрати автоматично (аналоги — за налаштуваннями, BR-SOFR-005, 008). */
  selectable: boolean;
}

export interface AllocationOptions {
  strategy: AllocationStrategy;
  /** Вага ціни для OPTIMAL, [0, 1]. */
  priceWeight: number;
  allowSplit: boolean;
  unknownDeliveryDays: number;
  now: Date;
}

export interface AllocationPart {
  offerId: string;
  qty: number;
  priceUah: number;
  days: number;
}

export interface AllocationResult {
  parts: AllocationPart[];
  /** Непокрита потреба (лишається окремою OPEN-позицією без пропозиції). */
  uncovered: number;
}

/**
 * Епсилон розподілу — окремий від QTY_EPSILON (1e-6): він гасить лише шум float-арифметики
 * кратності й частин (`qty / step`, залишок після віднімання частин) і входить в округлення
 * `roundUpToStep`; заміна на 1e-6 змінила б округлення на межі кратності, тобто сам розподіл.
 */
export const ALLOCATION_EPSILON = 1e-9;
const DAY_MS = 86_400_000;

interface Scored {
  o: AllocationOffer;
  price: number;
  days: number;
  step: number;
  /** Скільки можна замовити: найбільше кратне `step`, що не перевищує наявного. */
  orderable: number;
}

export function effectiveDays(
  o: AllocationOffer,
  opts: Pick<AllocationOptions, 'now' | 'unknownDeliveryDays'>,
): number {
  if (o.deliveryDays !== null && Number.isFinite(o.deliveryDays))
    return Math.max(0, o.deliveryDays);
  if (o.deliveryDate)
    return Math.max(0, Math.ceil((o.deliveryDate.getTime() - opts.now.getTime()) / DAY_MS));
  if (o.connectionDefaultDays !== null) return Math.max(0, o.connectionDefaultDays);
  return opts.unknownDeliveryDays;
}

/** Кількість, округлена до кратності вгору. */
export function roundUpToStep(qty: number, step: number): number {
  return Math.ceil(qty / step - ALLOCATION_EPSILON) * step;
}

export function allocateOffers(
  need: number,
  offers: AllocationOffer[],
  opts: AllocationOptions,
): AllocationResult {
  if (need <= ALLOCATION_EPSILON) return { parts: [], uncovered: 0 };
  const eligible: Scored[] = offers
    .filter(o => o.selectable && o.priceUah !== null && o.priceUah > 0 && o.qty > 0)
    .map(o => {
      const step = o.multiplicity && o.multiplicity > 0 ? o.multiplicity : 1;
      return {
        o,
        price: o.priceUah as number,
        days: effectiveDays(o, opts),
        step,
        orderable: Math.floor(o.qty / step + ALLOCATION_EPSILON) * step,
      };
    })
    .filter(s => s.orderable > ALLOCATION_EPSILON);
  if (eligible.length === 0) return { parts: [], uncovered: need };

  const compare = comparator(eligible, need, opts);

  // 1. Найкраща пропозиція, що покриває всю потребу.
  const covering = eligible
    .filter(s => roundUpToStep(need, s.step) <= s.orderable + ALLOCATION_EPSILON)
    .sort(compare);
  if (covering.length > 0) {
    const best = covering[0];
    return {
      parts: [
        {
          offerId: best.o.id,
          qty: roundUpToStep(need, best.step),
          priceUah: best.price,
          days: best.days,
        },
      ],
      uncovered: 0,
    };
  }

  // 2. Жадібно: склади одного постачальника — завжди; інші постачальники — лише з allowSplit.
  const ranked = [...eligible].sort(compare);
  const supplier = ranked[0].o.supplierId;
  const parts: AllocationPart[] = [];
  let remaining = need;
  for (const s of ranked) {
    if (remaining <= ALLOCATION_EPSILON) break;
    if (!opts.allowSplit && s.o.supplierId !== supplier) continue;
    const take = Math.min(roundUpToStep(remaining, s.step), s.orderable);
    if (take <= ALLOCATION_EPSILON) continue;
    parts.push({ offerId: s.o.id, qty: take, priceUah: s.price, days: s.days });
    remaining -= take;
  }
  // Залишок плаваючої коми (кратність 0.1, 0.2…) — не «непокрита потреба».
  return { parts, uncovered: remaining <= ALLOCATION_EPSILON ? 0 : remaining };
}

function comparator(all: Scored[], need: number, opts: AllocationOptions) {
  const total = (s: Scored) => s.price * roundUpToStep(need, s.step);
  // Межі нормування — один раз, не на кожне порівняння (було O(n) на compare).
  const range = (list: number[]) => ({ min: Math.min(...list), max: Math.max(...list) });
  const prices = range(all.map(s => s.price));
  const days = range(all.map(s => s.days));
  const norm = (v: number, r: { min: number; max: number }) =>
    r.max - r.min < ALLOCATION_EPSILON ? 0 : (v - r.min) / (r.max - r.min);
  const w = Math.min(1, Math.max(0, opts.priceWeight));
  const keys = (s: Scored): number[] => {
    switch (opts.strategy) {
      case 'CHEAP':
        return [total(s), s.days];
      case 'FAST':
        return [s.days, total(s)];
      case 'OPTIMAL':
        return [w * norm(s.price, prices) + (1 - w) * norm(s.days, days)];
      default: {
        const never: never = opts.strategy;
        return never;
      }
    }
  };
  return (a: Scored, b: Scored): number => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i++) {
      if (Math.abs(ka[i] - kb[i]) > ALLOCATION_EPSILON) return ka[i] - kb[i];
    }
    if (a.o.connectionPriority !== b.o.connectionPriority) {
      return a.o.connectionPriority - b.o.connectionPriority;
    }
    if (a.o.offerKey !== b.o.offerKey) return a.o.offerKey < b.o.offerKey ? -1 : 1;
    return a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0;
  };
}
