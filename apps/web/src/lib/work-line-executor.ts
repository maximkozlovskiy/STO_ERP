/**
 * Виконавець нової роботи наряду (BR-WO-030, рішення власника 2026-10-22).
 *
 * Хто підставляється, щойно в наряд додають роботу:
 *  1. механік запису наряду в календарі, якщо такий є;
 *  2. інакше — єдиний механік, закріплений за підйомником наряду;
 *  3. кілька механіків і запису немає → '' (обирає людина).
 * Не підставляються (тоді діє решта правила): механік зі статусом «У відпустці» і механік, у якого
 * задано категорії робіт без категорії цієї роботи. «Єдиний» — серед УСІХ механіків підйомника
 * (рішення власника 2026-10-22): двоє на підйомнику — поле порожнє, навіть якщо за категорією
 * підходить лише один; єдиний, що не підходить (відпустка, категорія), — теж порожнє.
 * Підставляється лише той, хто є в списку активних механіків (`activeMechanics`): інакше поле
 * виконавця його не покаже.
 *
 * Категорії: незадані в механіка (порожні чи невідомі — звужена відповідь для ролі механіка) не
 * обмежують. Категорія роботи невідома — механіка з категоріями не підставляємо: перевірити, що він
 * цю роботу виконує, нема чим.
 */

/** Механік підйомника з `GET /employees?liftId=&role=MECHANIC`: лише те, що потрібно правилу. */
export interface LiftMechanic {
  id: string;
  /** Немає — звужена відповідь (роль механіка): сервер уже віддав лише активних. */
  status?: string;
  /** Немає чи порожньо — категорії не задано, механік виконує будь-яку роботу. */
  workCategoryIds?: readonly string[] | null;
}

export interface PickLineExecutorInput {
  /** Механік запису наряду в календарі; `null` — запису з механіком немає. */
  calendarMechanicId: string | null | undefined;
  /** Механіки підйомника наряду; `null` — підйомника немає або список ще не отримано. */
  liftMechanics: readonly LiftMechanic[] | null | undefined;
  /** `Work.categoryId` роботи; `null` — невідома. */
  workCategoryId: string | null | undefined;
  /** Id активних механіків — тих, кого пропонує поле «Виконавець». */
  activeMechanicIds: readonly string[];
  /**
   * Рядки активних механіків (статус, категорії) — для механіка запису, якого немає серед механіків
   * підйомника (знятий з підйомника після запису): його категорії теж обмежують (Bug #942).
   * Немає рядка чи категорій — як і раніше, не обмежують.
   */
  mechanics?: readonly LiftMechanic[];
}

const ON_LEAVE = 'ON_LEAVE';

function handlesCategory(
  categories: readonly string[] | null | undefined,
  workCategoryId: string | null | undefined,
): boolean {
  if (!categories || categories.length === 0) return true;
  return !!workCategoryId && categories.includes(workCategoryId);
}

export function pickLineExecutor({
  calendarMechanicId,
  liftMechanics,
  workCategoryId,
  activeMechanicIds,
  mechanics,
}: PickLineExecutorInput): string {
  const active = new Set(activeMechanicIds);
  const onLift = new Map((liftMechanics ?? []).map(m => [m.id, m]));
  const known = new Map((mechanics ?? []).map(m => [m.id, m]));
  const eligible = (id: string, row: LiftMechanic | undefined) =>
    active.has(id) &&
    row?.status !== ON_LEAVE &&
    handlesCategory(row?.workCategoryIds, workCategoryId);

  if (
    calendarMechanicId &&
    eligible(calendarMechanicId, onLift.get(calendarMechanicId) ?? known.get(calendarMechanicId))
  ) {
    return calendarMechanicId;
  }
  const lift = liftMechanics ?? [];
  return lift.length === 1 && eligible(lift[0].id, lift[0]) ? lift[0].id : '';
}

/** Рядок запису календаря з `GET /work-orders/:id/linked-documents` (`calendarSlots[]`). */
export interface LinkedSlotMechanic {
  startAt: string;
  employeeId?: string | null;
}

/**
 * Механік запису наряду в календарі: найраніший запис, у якому механіка вказано. Сервер віддає
 * записи від найпізнішого, тож порядок відповіді не використовуємо.
 */
export function slotMechanicId(
  slots: readonly LinkedSlotMechanic[] | null | undefined,
): string | null {
  let best: LinkedSlotMechanic | null = null;
  for (const s of slots ?? []) {
    if (!s.employeeId) continue;
    if (!best || Date.parse(s.startAt) < Date.parse(best.startAt)) best = s;
  }
  return best?.employeeId ?? null;
}
